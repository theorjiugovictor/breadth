package main

import pb "example.com/cart/genproto"

type cartServer struct {
	pb.UnimplementedCartServiceServer
}

func (s *cartServer) AddItem(ctx context.Context, req *pb.AddItemRequest) (*pb.Empty, error) {
	return &pb.Empty{}, nil
}

func (s *cartServer) GetCart(ctx context.Context, req *pb.GetCartRequest) (*pb.Cart, error) {
	return &pb.Cart{}, nil
}
